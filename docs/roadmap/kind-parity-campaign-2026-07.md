# Geometry-kind & layer parity campaign (2026-07-21)

**Status: PLAN ONLY — nothing implemented.** Execution is designed for agent
teams/workflows run wave-by-wave, with the user in the loop between waves.

**Goal.** Make the "general tool" claim true: points, lines, polygons, and the
special animated layers should be _evenly_ supported across the whole pipeline
(build → format/runtime → render → demos → AI surface). Today investment is
demo-driven and lumpy: lines/trips are excellent, points very good, polygons
weakest end-to-end, and the special-layer shelf is bimodal (flow/AV families
deep; icon/hexagon/text/mesh/line/point-cloud shallow or orphaned).

**Provenance.** Four-agent parallel survey (2026-07-21) over `packages/layers`,
the Rust crates, `packages/{core,playback,three,mcp}`, and the showcase demo
registry. Key factual anchors are cited inline below; re-verify line numbers
before editing (tree moves fast).

---

## 1. Findings baseline (what we're fixing)

Maturity by kind:

| Kind           | Build (Rust)                                                                   | Runtime                | Render layers                              | Catalog demos |
| -------------- | ------------------------------------------------------------------------------ | ---------------------- | ------------------------------------------ | ------------- |
| Points         | solid, thin                                                                    | strong (summary tiers) | richest (wake/cumulative/splat/filters)    | 7+            |
| Lines/trips    | deepest (antimeridian split, DP/VW + TD-TR simplify, vertex time/value/matrix) | uniform                | trips family = flagship; plain paths basic | 12+           |
| Polygons       | weakest (no antimeridian, no standard-path simplify)                           | uniform                | window on/off only; seam overdraw          | 2             |
| Special layers | n/a (render-side views)                                                        | n/a                    | flow + AV deep; 6+ orphans                 | bimodal       |

The seven gaps, ranked:

1. **Polygons under-served at every stage** — antimeridian single-tile fallback
   (`crates/stt-build/src/tiler.rs:79-81`, counter at `:832-837`, pinned test
   `:3027`); no per-zoom simplification on the standard clip path
   (`tiler.rs:918-922`; `stt-core` has an unused `simplify_polygon`); render
   layer lacks DataFilter/timeHeightScale/cumulative; tile-seam overdraw.
2. **Moving-marker gap** — no position interpolation in point/icon/point-cloud
   layers (entities pop, don't glide); wake exists only on
   `AnimatedPointLayer`. `AnimatedIconLayer` (the natural AIS/flights layer:
   heading rotation exists) has no interpolation, no wake, no stable
   `colorMapping`, single-icon atlas constraint, zero demos.
3. **Orphan layers** — zero catalog demos: icon, hexagon, text, mesh, line,
   point-cloud (dead `type:'point-cloud'` branch in `buildDemoLayers.ts`),
   path (catalog-excluded datasets only). Showcase hand-rolls the AV ego from
   raw `SimpleMeshLayer` (`examples/showcase/src/components/av/egoLayers.ts`)
   instead of `AnimatedMeshLayer`.
4. **No path reveal** — `AnimatedPathLayer` is whole-path on/off; no
   progressive draw for timeless lines despite trail machinery next door.
5. **Cross-layer prop asymmetry** — wake/cumulative/DataFilter/
   `timeHeightScale`/stable `colorMapping`/fade each exist in an arbitrary
   subset of layers (per-demo accretion, not chassis capability).
6. **AI surface reach** — `view_map` inference emits only 6 of 23 layer types
   (`packages/mcp/src/view-map.ts:85-129`); archives without `layer_hint`
   silently fall back to `AnimatedPointLayer` (`view-map.ts:105-128`) — which
   is the entire currently-shipped R2 fleet (new builds bake the hint by
   default; fleet not republished).
7. **Smaller generality edges** — optimizer cost/density modeling is
   centroid-based (approximate for lines/polygons, self-documented in
   `stt-optimize/src/analysis/density.rs:154-158`); summary tiers only ever
   _recommended_ for points (`advisors/budget.rs:122-128`); Multi\* collapse;
   native GeoArrow line/polygon rejected (`input.rs:1031-1044`); `timesSorted`
   partial decode declared, unimplemented.

---

## 2. Campaign constraints (binding on every agent)

- **No thinning.** Features are never dropped. Per-zoom geometric
  simplification (the lines `detail-zoom` lever) is the allowed density lever;
  the max-tiled-zoom tier stays lossless. Summary tiers stay opt-in.
- **Git safety.** No `git checkout -- .` / `reset --hard` / bulk reverts —
  ever. Targeted `git restore <file>` only. Lint = oxlint + oxfmt.
- **Worktrees need a committed HEAD.** Phase 0 commits the current uncommitted
  tree before any worktree-isolated fan-out; until then parallel agents must
  not mutate overlapping files in the main tree.
- **Aesthetics are user-verified in-browser.** Agents wire demos and stop; no
  Playwright screenshot loops to judge look. Every demo change ends in an
  explicit "user visual-verify" checkpoint.
- **Reduced motion.** Every new animated surface gates on `useReducedMotion()`.
- **Showcase consumes package dist.** After editing `packages/{layers,playback,core}`
  source, rebuild their dist or the showcase renders stale code.
- **defaultProps gotcha.** Explicitly-passed `undefined` shadows layer
  defaultProps — prop-plumbing sweeps must not spread optional props blindly.
- **Blob-ordering rule.** Any archive rebuild for a multi-cell playback demo
  uses `--blob-ordering time-major`, never `auto`.
- **Conformance is part of done.** New layer kinds/props update both backend
  descriptors (`packages/layers/src/backend-descriptor.ts`,
  `packages/three/src/backend-descriptor.ts`) and their conformance tests —
  either implement in three or declare a typed fallback deliberately.

---

## 3. The team: agent archetypes & workflow shapes

Recurring archetypes (instantiated per phase; counts are per-workflow):

- **Designer panel** — 3 independent designers with distinct angles
  (minimal-diff, correctness-first, prior-art/SOTA) → 2–3 judges → synthesis
  agent. Output lands as a design section in this doc. Used where the approach
  is genuinely open (A1 antimeridian polygons, B1 interpolation, polygon seam
  overdraw).
- **Implementer** — owns a named file cluster; worktree-isolated only when
  clusters overlap. Writes code + targeted tests together.
- **Adversarial verifier** — per change, prompted to _refute_ (wrong output,
  perf regression, gotcha violation); majority-refute kills the change back to
  the implementer.
- **Demo builder** — dataset recipe (per `stt-showcase-build-recipes` memory) +
  `datasets.ts`/`buildDemoLayers.ts`/`demoMeta.ts` wiring + reduced-motion
  gate; stops before aesthetics.
- **Integrator gate** (sequential, end of each wave) — `cargo test`, vitest
  across packages, oxlint/oxfmt, dist rebuild, conformance suites. A wave is
  not done until this gate is green.
- **Reviewer sweep** (end of each track) — multi-dimension find → adversarial
  verify (the canonical review workflow); confirmed findings are fixed before
  the track closes.

Standard workflow shapes: _design panel_ (judge pattern), _implement pipeline_
(`pipeline(items, implement → test → verify)` — no barriers between stages),
_review_ (find → dedup → adversarial verify), _integrate_ (sequential gate).

---

## 4. Tracks and phases

### Phase 0 — prerequisites (blocks all worktree fan-out)

- **P0.1 Commit the current tree** (AI-recommender campaign + 2026-07-18
  review fixes, all green). **User decision — agents must not commit
  unprompted.**
- **P0.2 Baseline snapshot** — record suite/lint status and per-demo archive
  inventory so regressions are attributable.

### Track A — Polygon parity (Rust + TS)

- **A1 Antimeridian polygon clipping.** Design panel first (candidate shapes:
  normalize-and-split at ±180° mirroring the polyline split at
  `clip.rs:817-844`; or clip in a lon-shifted frame and re-wrap). Then
  implement in `clip.rs`/`tiler.rs`, proptest + golden fixtures (Fiji,
  Chukotka, dateline-crossing storm cells), deliberately retire the pinned
  fallback contract test. **Gate:** `antimeridian_fallbacks == 0` on the test
  corpus; roundtrip/property tests green.
- **A2 Polygon per-zoom simplification** on the standard clip path — parity
  with lines' DP/VW + `simplify_max_zoom`; topology-preserving (rings valid,
  holes intact), max-zoom tier untouched (no-thinning). **Gate:** measured
  byte reduction on wildfires/rain-flood rebuilds; no visible loss at max
  zoom (user visual-verify).
- **A3 Render parity for `AnimatedPolygonLayer`** — add `DataFilterExtension`
  - `timeHeightScale`; design-spike the tile-seam overdraw (clip-edge flags
    from build vs render-side dedup — panel decides build/render split).
    Descriptors + conformance updated.
- **A4 Third polygon demo** (non-weather; candidates: OSM building footprints
  appearing over time, sea-ice extent) + docs. User visual-verify.

### Track B — Motion parity (TS chassis)

- **B1 Interpolation design spike.** Per-entity position interpolation for
  window-filtered point-family layers. The hard part is sample pairing
  (points are independent rows): load-time id-indexed pairing (generalize
  trip-heads' binary search), build-side baked next-sample offsets, or
  synthetic 2-vertex segments. Also decides whether it rides
  `TimeFilterExtension` or a sibling extension. Design panel; output recorded
  here before any implementation.
- **B2 Implement interpolation** for `AnimatedPointLayer` +
  `AnimatedIconLayer` (point-cloud if cheap). **Gate:** ship-traffic/flights
  glide; frame-time budget unchanged (measured, not eyeballed).
- **B3 Wake exposure sweep.** `TimeFilterExtension` already has
  window/trail/wake/cumulative modes; only the point layer wires wake. Expose
  wake on icon (+ point-cloud optional) with per-layer tail semantics.
- **B4 `AnimatedIconLayer` rebuild** — per-category icon atlas, stable
  `colorMapping`, wake + interpolation from B2/B3; switch ship-traffic or
  flights to icons (AIS `cog` heading exists). User visual-verify.
- **B5 Prop-parity sweep** against the target matrix (§5): DataFilter to
  column/arc/line/trips (+polygon via A3), `timeHeightScale` to
  polygon/column, stable `colorMapping` to icon/arc/line/column. One
  implementer per layer file; shared chassis-driver test harness extended
  once, first. Mind the defaultProps gotcha.

### Track C — Orphan adopt-or-cut

- **C1 Decision pass** (cheap, before any build-out): per orphan
  (hexagon, text, mesh, line, point-cloud, path, unused
  DataFilter/Collision showcase composition) an adopt-or-cut recommendation
  with evidence; **user ratifies the list** before C2+ runs. Icon is
  pre-decided (adopt, B4).
- **C2 Mesh adoption** — productize the showcase ego hand-roll onto
  `AnimatedMeshLayer` (first real consumer; `egoLayers.ts` becomes a thin
  config).
- **C3 Path reveal** — trail/progressive-draw mode for `AnimatedPathLayer`
  (reuse TimeFilterExtension trail mode + synthesized vertex times); promote
  `flight-paths` or `nyc-taxi-paths` into the catalog. Sequenced after B1
  (touches the same extension).
- **C4 Point-cloud** — wire the dead `type:'point-cloud'` branch to a real
  dataset (a lidar variant) or delete the branch and deprecate the export.
- **C5 (stretch)** — productize the space-time-cube overlay (DemoViewer
  lattice + now-plane) and `GroundedTile3DLayer` as package layers.

### Track D — AI surface reach

- **D1 Widen `view_map` inference** — use baked `layer_hint` + recommend
  `dominant_type`; extend `LAYER_HINT_TO_TYPE`; intent promotions to special
  layers (OD→arc, density→heatmap/summary, magnitude→column); never silently
  default to points when geometry is unknown (warn loudly or refuse).
  TS-only, independent of A/B — can run in Wave 1.
- **D2 Fleet republish with baked `layer_hint`** — folds into open-register
  item 1 (rollout/verify ops gate) together with the 5 weather archives and
  the polygon rebuilds from A2. User-run ops gate; blob-ordering rule
  applies.
- **D3 Docs/skills** — update `wiring-deckgl-layers` skill, llms.txt, MCP
  tests for every new mode/layer reachable.

### Track E — counted out (backlog with triggers)

- Optimizer clip-aware cost modeling for lines/polygons — trigger: A2 rebuild
  advice visibly wrong on polygon datasets.
- Summary-tier recommendation for line/polygon sources — trigger: demand.
- Native GeoArrow line/polygon ingestion — trigger: ecosystem/user demand.
- First-class Multi\* identity — trigger: picking/styling needs whole-multi
  identity.
- `timesSorted` partial decode — belongs to
  [space-time-lod-2026-07.md](./space-time-lod-2026-07.md); not duplicated
  here.

---

## 5. Target capability matrix (per-feature binary family)

`Y` = has it · `→Y` = campaign target · `O` = optional/stretch · `–` = n/a by
design. CPU-row family (bbox/mesh/text), summary family, and flow family keep
their own contracts and are out of this matrix.

| Layer       | window+fade | trail/reveal | wake    | cumulative | interp  | DataFilter | timeHeightScale | stable colorMapping |
| ----------- | ----------- | ------------ | ------- | ---------- | ------- | ---------- | --------------- | ------------------- |
| point       | Y           | –            | Y       | Y          | →Y (B2) | Y          | Y               | Y                   |
| path        | Y           | →Y (C3)      | –       | O          | –       | Y          | Y               | Y                   |
| polygon     | Y           | –            | –       | O          | –       | →Y (A3)    | →Y (A3)         | Y                   |
| arc         | Y           | –            | –       | –          | –       | →Y (B5)    | Y               | →Y (B5)             |
| line        | Y           | –            | –       | –          | –       | →Y (B5)    | Y               | →Y (B5)             |
| icon        | Y           | –            | →Y (B3) | –          | →Y (B2) | →Y (B5)    | Y               | →Y (B4)             |
| column      | Y           | –            | –       | –          | –       | →Y (B5)    | →O (B5)         | →Y (B5)             |
| point-cloud | Y           | –            | O       | –          | O       | O          | Y               | Y                   |
| trips       | (trailFade) | Y            | –       | O          | Y       | →Y (B5)    | Y               | Y                   |

The B5 sweep executes against this table; conformance tests pin the end state.

---

## 6. Sequencing (waves ≈ workflow sessions)

Dependencies: A1/A2 (Rust) ⊥ B/C/D (TS). B1 before B2/B3/B4 and before C3.
A3 after A1/A2 land (rebuilt fixtures). D2 last (wants A2's polygon rebuilds
so the fleet republishes once). C2/C4/C5 gated on C1 ratification.

- **Wave 1 — spikes + independents** (~12–15 agents): P0 (user commit) →
  design panels A1 + B1 in parallel; D1 implement; C1 decision pass.
  Checkpoint: user ratifies designs + adopt-or-cut list.
- **Wave 2 — parallel deep tracks** (~15–20 agents): Rust workflow (A1
  implement + A2) ∥ TS workflow (B2 + B3 + B4). Integrator gate each.
- **Wave 3 — convergence** (~15–20 agents): A3 + B5 matrix sweep + C2 + C3 +
  C4; A4 demo build. Integrator gate; user visual-verify batch (all changed
  demos in one browser pass).
- **Wave 4 — close-out** (~10–15 agents): per-track reviewer sweeps
  (find → adversarial verify → fix); D3 docs/skills; D2 republish decision
  with the user; roadmap/README + memory updates.

Rough scale: ~60–70 agents total across four sessions. Each wave ends with the
integrator gate green and a short state update appended to this doc, so any
later session (or workflow) can resume from the doc alone.

## 7. Definition of done

1. Polygon parity: no antimeridian fallbacks; per-zoom simplification on par
   with lines; A3 props shipped; ≥3 catalog polygon demos.
2. Motion parity: point/icon glide + wake; icon layer is the flagship vehicle
   layer with a catalog demo.
3. No orphan exports: every `@poopdeck.gl/layers` export has a catalog demo,
   an AV-cockpit surface, or was deliberately cut/deprecated in C1.
4. §5 matrix fully realized (`→Y` cells become `Y`) and pinned by tests.
5. `view_map` can reach every exported layer via hint/intent; unknown geometry
   is never silently points; fleet republished with baked hints.
6. All suites green (cargo, vitest, conformance), oxlint/oxfmt clean, user
   visual-verify completed per changed demo.

---

# Wave 1 results (2026-07-21) — RATIFIED 2026-07-21

Executed as a 17-agent workflow (baseline + A1/B1 design panels + C1 adopt-or-cut,
all read-only in parallel; D1 implemented after a barrier). 17/17 agents, 0 errors.
**User ratified 2026-07-21:** A1 + B1 designs approved as-is (recommended defaults on
their open sub-questions); C1 reconciled table approved; D1 accepted; Wave 2 Rust
track (A1) started. Full agent transcripts are archived in the session's workflow journal.

## P0.2 baseline (attribution reference)

- **cargo test --workspace:** green (spec-conformance 8/8, stt-generate 139/139,
  stt-optimize 102/102, all other crates + doctests). No pre-existing Rust failures.
- **vitest:** all packages green — cesium 44, core 494, layers 716, maplibre 98,
  mcp **148** (pre-D1), playback 167, react 38, three 292.
- **Pre-existing lint debt (NOT the campaign's):** `oxlint` reports 13 errors
  (showcase StoryGlobe/MaplibreRenderer hooks-deps, demo-meta-contract,
  cesium/layers/core/mcp/three, tools/render-test); `oxfmt --check` flags 2 files
  (`stt-packed-format-decisions.md`, `tools/bench/src/bench.mjs`). Recorded so
  later regressions are attributable. *(Several of these were being cleaned up in
  the working tree concurrently during the run.)*
- **Archive inventory:** 128 dataset entries; explicit `type:` distribution —
  trips ×14, point ×8, trip-heads ×5, av ×5, summary ×2, radar ×2, polygon ×2
  (wildfires, hurricanes), path ×2 (both catalog-excluded), flowmap-bundled ×2,
  and one each of weather/quadbin-summary/lightning/heatmap/flowmap/column/arc.
  Only 3 archives carry a baked H3/Quadbin summary tier — relevant to D2 republish.

## A1 design — Antimeridian polygon clipping (Rust)

**Chosen approach: "split-then-reuse."** Both judges converged on the same hybrid.
Add a pure-arithmetic `split_polygon_at_antimeridian(&PolygonRings) -> Vec<PolygonRings>`
to `clip.rs` that turns a dateline-crossing polygon into per-hemisphere sub-polygons
(each wholly in `[-180,180]`, no `|Δlon|>180°` edge), which then flow through the
**unchanged** `clip_polygons_to_tiles` sweep. Do the meridian cut/re-close by reusing
the existing, already-tested `sutherland_hodgman_ring` **verbatim** (pass a meridian-only
`TileBounds` — `max_lon=S` for the west piece, `min_lon=S` for the east, the other three
half-planes made no-ops via a large sentinel). **No `clip_axis` extraction, no edit to
the byte-reproducibility-critical clipper.**

**Trigger change:** replace the current `bbox > 180°` fallback test
(`tiler.rs:832-837`) with the per-vertex `|Δlon| > 180°` **edge-jump** test the polyline
splitter already uses (`clip.rs:831`). This is strictly more correct — a wide but
non-crossing polygon (−170°→+170° across lon 0, bbox 340°) is no longer wrongly dumped
whole. `antimeridian_fallbacks` is demoted to a should-be-0 dead-letter for genuinely
unsplittable (pole-enclosing / empty-split) rings.

**Algorithm (per polygon):** ① `unwrap_ring` — drop the closing dup, walk vertices
accumulating a `±360` offset at each `|Δlon|>180°` seam so no edge jumps the seam;
② unwrap the exterior → lon-bbox; translate each hole into the exterior's continuous
frame (`round((ec-hc)/360)*360`); ③ pick seam `S` = the unique odd multiple of 180 inside
the unwrapped bbox (0 or >1 candidates ⇒ degenerate ⇒ empty ⇒ dead-letter); ④ cut every
ring at `x=S` via verbatim `sutherland_hodgman_ring`, once per side — west and east
evaluate the **same** `t=(S-prev.x)/(cur.x-prev.x)` on the same edge, so seam latitudes are
**bit-identical** (watertightness for free); ⑤ normalize each side back into `[-180,180]`
by one uniform `k*360` shift (exterior + its holes by the same `k` ⇒ area & winding
preserved); ⑥ shoelace winding-guard (CCW exterior / CW holes), runs only on the split
path so non-crossing output stays byte-identical; ⑦ assemble `[west, east]`, dropping
rings that clipped empty. z0 emits both halves as a `MultiPolygon`; deeper zooms land each
side only in its hemisphere's columns.

**Files:** `clip.rs` (new fn + `unwrap_ring`/seam/normalize/winding helpers + unit tests,
reword the `clip_polygons_to_tiles` precondition); `tiler.rs` (trigger swap in
`place_polygon`, factor the empty-handling + piece-mapping tail into a closure over the
working set, reword the counter docs, **retire the pinned single-tile-fallback test at
`tiler.rs:3040` and replace with a corpus placement test**); new
`tests/antimeridian_polygon.rs` + `tests/fixtures/antimeridian/` (Fiji MultiPolygon,
Chukotka, dateline storm cell with a seam-straddling hole); `stt-core/geometry.rs`
**no change** (`simplify_polygon` stays out — it must run *after* split + per-tile clip).

**Acceptance gate:** on the dateline corpus at every zoom — `antimeridian_fallbacks == 0`;
all rings closed, in `[-180,180]`, no `|Δlon|>180°` edge; CCW exterior / CW holes retained
& contained; planar area conserved within ε; pieces on **both** sides of the dateline
(no single-tile smear); stt-serve single-tile output bit-identical to the full build; all
pre-existing clip/tiler tests green; `cargo fmt --check` + `clippy` clean.

**Primary risk:** seam watertightness (silent) — pin with a dedicated seam-bit-equality
test mirroring `clip.rs:1620-1641`, and enforce "simplify only after split + per-tile clip."
Seam-tangent holes (a hole touching the shell along the ±180 meridian) are an unavoidable,
renderer-tolerated artifact — property tests must explicitly tolerate a hole edge on the
seam (consistent with the existing accepted-artifact stance at `clip.rs:954-963`).

**Open questions for the user (A1):**
1. Keep the existing `antimeridian_fallbacks` counter as a should-be-0 safety net
   (recommended, no schema churn) **or** add a distinct `antimeridian_splits` observability
   counter (touches summary/report/CLI consumers)?
2. Ratify that a seam-tangent hole is acceptable output (so property tests tolerate
   edge-tangency rather than failing strict OGC simplicity).
3. Area epsilon measured in planar lon/lat degrees² (what cut+translate conserves exactly)
   vs geodesic m²?
4. Pole-enclosing (Antarctica-class) rings: defer to a follow-up (recommended — counted +
   placed-whole, never dropped) or handle in-scope now?
5. `simplify_polygon` wiring: leave out of this task (recommended) and only fix its
   post-split ordering, or bundle per-zoom polygon simplification here?
6. Confirm retiring the pinned `tiler.rs:3040` fallback test is sanctioned.

## B1 design — Per-entity motion interpolation ("glide mode")

**Chosen approach: opt-in CPU "glide" render path reusing the existing
`packages/layers/src/lib/track-kernel.ts` engine** on `AnimatedPointLayer` +
`AnimatedIconLayer`, selected by an `interpolate` prop + an `idProperty` naming an
**exact per-entity id column**. Both judges ranked track-kernel reuse first.

**Architecture answer (the task's open question):** it is **neither** a
`TimeFilterExtension` mode **nor** a GPU sibling extension — a shader cannot gather the
two arbitrary rows (often in different tiles) of the *same* entity that bracket the
playhead, so interpolation must be a CPU `renderLayers()` path, exactly like the shipping
box/mesh/trip-heads layers. `track-kernel.ts` already solves the hard part (group-by-id,
rebase to absolute epoch-ms so cross-tile samples share a timeline, sort/dedup,
binary-search + lerp, shortest-arc heading, singleton hold, fade) and is already consumed
by the box and mesh layers.

**Grafts onto the winner:** ① `maxInterpolationGap` **hold-last** guard — a silent entity
holds its last sample instead of fabricating straight-line motion through a data hole
(integrity, not cosmetics); ② a lean typed-array output core pre-committed as B2's measured
fallback; ③ **degrees-aware angle lerp** (`lerpAngleDeg`) — `IconLayer.getAngle` is DEGREES,
`track-kernel.lerpAngle` is RADIANS (a real bug caught, `animated-icon-layer.ts:135`);
④ never pair on `binary.featureIds`/`id` (per-row unique); ⑤ bearing-from-position-delta
fallback when an icon has no heading column.

**Schema findings (load-bearing):** `flights` is **ready today** — `icao24` is
`Dictionary(UInt16,Utf8)` → `categoricalProps`, groups with track-kernel unchanged, no
rebuild → first wired glide demo (`idProperty:'icao24'`). `ais-all-us` **needs a rebuild**
— `mmsi` exists only as a lossy quantized `UInt16` that collides distinct vessels, so glide
ships inert on AIS until an exact vessel id is emitted.

**Default-off is byte-identical:** with `interpolate` off (or `reducedMotion` on) the
existing GPU window/wake/cumulative path is untouched; `_handleTimeUpdate` bumps the
interpolation counter only when the branch is active and sim-time advanced. Reduced-motion
gates via a **concrete boolean** (survives the explicit-undefined-shadows-default gotcha).

**Files:** `track-kernel.ts` (`lerpAngleDeg`, `angleUnit`, `maxGapMs`, optional lean core),
`animated-point-layer.ts` + `animated-icon-layer.ts` (`renderInterpolated()` + cache +
`_handleTimeUpdate` override + picking), `index.ts` re-export, showcase `types.ts` +
`buildDemoLayers.ts` (thread `reducedMotion`, conditional-spread `idProperty`, concrete
`interpolate`, wire `flights`), `DemoViewer.tsx` + `DemoHoverPreview.tsx` (pass
`reducedMotion`), + new track-kernel/point/icon/**frame-budget** tests.

**Acceptance gates (B2 is measured, not eyeballed):** G1 default-off byte-identical; G2
`renderLayers` p95 under an agreed ceiling at **both** showcase and AIS worst-case active
counts, index build once per tile-set-ref change; G3 reduced-motion honored; G4 cross-tile
seam glides with no pop; G5 max-gap holds last; G6 degrees heading shortest-arc (no spin);
G7 glided marker picks back to its source; G8 no thinning + lint clean.

**Open questions for the user (B1):**
1. AIS: ratify a rebuild emitting an exact vessel id, or accept AIS glide inert for now —
   and is **`flights` an acceptable first glide demo**?
2. Wake vs glide (mutually exclusive in v1): keep wake and wire glide to a new demo,
   replace wake, or greenlight a combined glide+wake follow-up?
3. Reduced-motion fallback: discrete-snap to the GPU path (recommended) vs hold-last-static?
4. `maxInterpolationGap` default + per-dataset overrides (AIS seconds–minutes; drifters ~6 h)?
5. B2 budget: agree the p95 ceiling and the AIS worst-case active-vessel count to measure at.
6. Is icon glide capability-only for now (no showcase icon demo exists), or wire a demo?
7. Confirm track-kernel is **not** extended to group on a numeric id (exact categorical id
   avoids the quantization-collision trap by construction).

## C1 — Orphan adopt-or-cut (surveyor + adversarial challenger)

The surveyor produced initial verdicts; the challenger contested the strength of **5 of 7**.
The **reconciled** recommendation (surveyor ∧ challenger) — for user ratification:

| # | Orphan | Surveyor | Challenger | **Reconciled** |
|---|--------|----------|-----------|----------------|
| 1 | `AnimatedHexagonLayer` | ADOPT (hexbin over earthquakes/nyc-taxi) | near-duplicate of shipped earthquakes points **and** extruded-column demos; nyc-taxi weights are pre-aggregated, not raw | **DEFER** unless a genuinely different pickable-per-cell dataset is chosen |
| 2 | `AnimatedTextLayer` | ADOPT (earthquake/GTFS labels) | rests on an **unverified** string-column prerequisite; drags in CollisionFilter | **DEFER** until `describe_dataset` confirms a shipped archive with a string column |
| 3 | `AnimatedMeshLayer` | ADOPT (glTF meshes for AV objects) | re-skins existing AV boxes → **zero new info** + permanent bundle cost | **DEFER** until a non-AV moving-mesh dataset where shape carries meaning (ships over AIS, aircraft over flights) |
| 4 | `AnimatedLineLayer` | ADOPT (flat OD, mirror nyc-od-arcs) | flat clone of the arc hero over identical geometry; no named dense-OD dataset | **DEFER**, trigger = a genuinely dense OD matrix lands |
| 5 | `type:'point-cloud'` branch | **CUT** branch, keep export | AV composite can't show a *bare* cloud; cutting forces deleting a designed VizBadge glyph; catalog lidar exists to wire it | **Keep — DEFER** (leave dormant at ~zero cost) **or ADOPT** by pointing it at an existing standalone lidar sweep. *Do not cut.* |
| 6 | `AnimatedPathLayer` | DEFER ("not an orphan") | it's a real catalog-reach GAP; the `path` case is already wired, a window-fix rebuild gives it a hero cheaply | **ADOPT-cheap candidate** (C3): rebuild one path dataset with a corrected window |
| 7 | `DataFilterExtension` / `CollisionFilterExtension` | DEFER both | split them — DataFilter's trigger (point hero + numeric column, wiring done) **exists today** | **ADOPT DataFilter now** (magnitude slider on earthquakes points); **DEFER Collision** (rides the Text demo) |

Net: the challenger pushes the campaign away from cosmetic/near-duplicate adopts (hexbin,
mesh, flat-line, text-without-a-column) and toward two genuinely cheap wins already wired —
**DataFilter magnitude slider** and a **path-reveal hero** (C3) — plus **do not cut** the
point-cloud branch (keep it dormant). *This table is the ratification target for C2+.*

## D1 — `view_map` inference widening (IMPLEMENTED, uncommitted, green)

**Landed in `packages/mcp` only** (`presentation.ts`, `view-map.ts`, `server.ts` +
`presentation.test.ts`, `view-map.test.ts`). Build + `vitest` green: **162/162** (was 148 →
+14 tests). Adversarial verifier: **approve**, all six refutations refuted, no revise round.

- **Hint mapping is already complete:** the build side emits **only**
  `points|paths|trips|polygons` (`stt-build/style_hints.rs` + `stt-optimize` `LAYER_HINTS`),
  all four already mapped. No new hint mappings were invented (the archive cannot carry them).
- **New reach via intent promotion** (in `presentation.ts`, kept DRY): `flow` → `AnimatedArcLayer`
  (from path/trips geometry), `magnitude` → `AnimatedColumnLayer` (from point geometry).
  Geometry-gated: promote only when geometry supports it, else keep base + warn.
- **Never silently points:** unknown geometry keeps the `AnimatedPointLayer` fallback
  (contract preserved) but now always fires a loud **"⚠ UNRELIABLE LAYER"** advisory naming the
  dataset and every escape hatch (`layer`, `intent`, rebuild). `server.ts` tool description +
  intent enum updated.

**Important finding — corrects DoD item 5.** `view_map` reads only `manifest.json`, and the
archive carries **no signal** for most special layers (Heatmap/Hexagon/Icon/Line/Text/Mesh/
PointCloud/Flow\*) — and `recommend`'s `dominant_type` is **not** baked into the manifest, so
`view_map` cannot see it. Therefore "`view_map` can reach *every* exported layer via hint/intent"
is **not achievable from the archive alone**; those layers remain reachable only via an explicit
`layer` override. Closing this requires a **build-side format change** to emit richer hints (an
`od` flag, a heading/weight marker, or baking `dominant_type` into the manifest). → **new Track E
backlog item** (see below); DoD item 5 should be softened accordingly.

## Wave 1 → Wave 2 gate — CLEARED 2026-07-21

- **P0.1 commit:** ✅ done by the user (`bc521cf`) — worktree fan-out is unblocked.
- **Ratified:** A1 design (defaults: keep the existing `antimeridian_fallbacks` counter;
  defer pole-enclosing and `simplify_polygon` wiring; seam-tangent holes accepted; area ε
  planar; retire the `tiler.rs:3040` pin); B1 design (defaults: `flights`-first via `icao24`,
  discrete-snap reduced-motion, do NOT extend the kernel to numeric ids; wake-vs-glide is a
  deferred B4 product call); C1 reconciled table; D1 accepted with softened DoD-5.
- **New Track E item (from D1):** build-side hint enrichment so `view_map` can infer special
  layers — trigger: demand for zero-`layer`-param special-layer inference.

## Wave 2 — Rust track

- **A1 implement — DONE 2026-07-21, green, uncommitted.** Split-then-reuse implemented in
  `clip.rs` (new `split_polygon_at_antimeridian` + 6 helpers, `sutherland_hodgman_ring` reused
  verbatim, no `clip_axis` extraction) and `tiler.rs` (edge-jump trigger, pinned `:3040` test
  retired + replaced, counter docs reworded). New `tests/antimeridian_polygon.rs` (golden +
  seeded proptest) + 3 GeoJSON fixtures (a nested `.gitignore` re-includes them past the root
  `*.geojson` blanket ignore). `simplify_polygon` left unwired per the ratified default.
  - **Adversarial verify caught one confirmed HIGH bug (both lenses):** a MultiPolygon with a
    dateline-crossing part silently DROPPED its non-crossing parts (`crosses` was feature-wide;
    the split path `flat_map`ped the splitter over every part, and it returns empty for a
    non-crosser — e.g. a USA multipolygon would lose CONUS when the Aleutians cross ±180).
    **Fixed:** `place_polygon` now routes per-part (split only crossing parts, pass non-crossers
    through; a crossing part that is itself unsplittable dead-letters the whole feature to the
    legacy whole placement, counted, never dropped). Regression test
    `antimeridian_multipolygon_keeps_noncrossing_part` added.
  - **Gate:** `cargo test -p stt-build -p stt-core` = **360 passed / 0 failed**; A1 adds no new
    clippy warnings; `antimeridian_fallbacks == 0` on the dateline corpus at every zoom.
  - *(The 2 re-verify agents + the integrator-gate agent died on a session limit; the fix,
    regression test, and gate were completed in the main loop after the reset.)*
- **A2 (polygon per-zoom simplification):** next Rust step. Its ordering constraint requires
  the split to be in place first (now satisfied). Wires `simplify_polygon` on the standard clip
  path, post-split, max-zoom tier lossless.
- **TS track (B2/B3/B4):** waits until the user commits the current working tree (it touches
  `packages/layers` + showcase, which carry uncommitted user edits — worktree fan-out from
  HEAD would not see them).
